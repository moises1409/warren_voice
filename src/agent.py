import asyncio
import contextlib
import json
import logging
import os

from dotenv import load_dotenv
from google.genai import types
from livekit import rtc
from livekit.agents import (
    AgentServer,
    AgentSession,
    JobContext,
    TurnHandlingOptions,
    cli,
    inference,
    room_io,
)
from livekit.plugins import ai_coustics, google

from models import Stage
from prompts import LANGUAGES, after_button, step_brief
from sessions import SessionStore
from stages import AGENTS, Prep, make_agent, speak_unprompted
from store import ClientNotFoundError, PrepStore

logger = logging.getLogger("agent")

load_dotenv(".env.local")

# Topic of the text stream that carries the full session state to the frontend.
STATE_TOPIC = "warren.state"
# Used when the job carries no client, for example in console mode.
DEFAULT_CLIENT_ID = os.environ.get("WARREN_DEFAULT_CLIENT", "c-001")
# Dispatch name this worker registers under. The frontend's AGENT_NAME must match.
# Give each environment its own name: workers that share a name share the sessions.
AGENT_NAME = os.environ.get("AGENT_NAME") or "warren-prep"


def build_llm(language: str = "en") -> google.realtime.RealtimeModel:
    return google.realtime.RealtimeModel(
        model="gemini-3.1-flash-live-preview",
        voice="Enceladus",
        language=LANGUAGES.get(language, LANGUAGES["en"])[1],
        # At the default "minimal" level the model skipped the recording tool in
        # about a third of turns while saying it had recorded; "low" fixes that.
        thinking_config=types.ThinkingConfig(
            thinking_level="low", include_thoughts=False
        ),
    )


def launch_from(metadata: str | None) -> dict:
    """What the frontend asked for in the dispatch metadata: the client, the mode, a fresh start."""
    try:
        launch = json.loads(metadata or "{}")
    except ValueError:
        launch = {}
    if not isinstance(launch, dict):
        launch = {}
    if not launch.get("clientId"):
        logger.warning("no clientId in job metadata, using %s", DEFAULT_CLIENT_ID)
        launch["clientId"] = DEFAULT_CLIENT_ID
    return launch


def client_id_from(metadata: str | None) -> str:
    """The client to prepare, as sent by the frontend in the dispatch metadata."""
    return launch_from(metadata)["clientId"]


class StatePublisher:
    """Sends the latest state snapshot to the room, never an older one after a newer one."""

    def __init__(self, room: rtc.Room, store: PrepStore) -> None:
        self._room = room
        self._store = store
        self._dirty = asyncio.Event()
        self._task = asyncio.create_task(self._run())
        store.subscribe(lambda _: self._dirty.set())

    def publish(self) -> None:
        self._dirty.set()

    async def _run(self) -> None:
        while True:
            await self._dirty.wait()
            self._dirty.clear()
            try:
                await self._room.local_participant.send_text(
                    self._store.snapshot(), topic=STATE_TOPIC
                )
            except Exception:
                logger.exception("failed to publish state")

    async def aclose(self) -> None:
        self._task.cancel()


async def on_chat_text(session: AgentSession, ev: room_io.TextInputEvent) -> None:
    """Answer a typed message, waiting out a stage change instead of dropping it.

    While one stage agent hands over to the next the session accepts no new
    speech for a moment; a message typed in that window would otherwise be lost.
    """
    prep: Prep = session.userdata
    # Let a stage change in progress finish, so the new stage's agent answers.
    with contextlib.suppress(asyncio.TimeoutError):
        await asyncio.wait_for(prep.stage_ready.wait(), timeout=10)
    for _ in range(20):
        try:
            await session.interrupt()
            session.generate_reply(user_input=ev.text)
            return
        except RuntimeError:
            await asyncio.sleep(0.5)
    logger.warning("chat message dropped: the session did not become ready")


server = AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
async def my_agent(ctx: JobContext):
    launch = launch_from(ctx.job.metadata)
    sessions = SessionStore()
    try:
        store = PrepStore.load(
            launch["clientId"], sessions=sessions, reset=bool(launch.get("reset"))
        )
    except ClientNotFoundError as e:
        logger.error("unknown client %s, using %s", e, DEFAULT_CLIENT_ID)
        store = PrepStore.load(DEFAULT_CLIENT_ID, sessions=sessions)
    if launch.get("language") in LANGUAGES:
        store.set_language(launch["language"])
    if launch.get("mode") in ("guided", "listening"):
        store.set_mode(launch["mode"])
    else:
        # Saves the session, so the page shows it as worked on from now on.
        store.set_mode(store.state.mode)
    prep = Prep(store=store)
    ctx.log_context_fields = {
        "room": ctx.room.name,
        "client": store.state.client.id,
    }

    session = AgentSession[Prep](
        llm=build_llm(store.state.language),
        userdata=prep,
        turn_handling=TurnHandlingOptions(
            # The LiveKit turn detector determines when the user is done speaking and the agent should respond.
            # See more at https://docs.livekit.io/agents/build/turns
            turn_detection=inference.TurnDetector(),
            # Adaptive interruptions use the turn detector to tell a real interruption from a
            # backchannel like "mhm" or "right", so the agent keeps talking through the latter.
            interruption={"mode": "adaptive"},
            preemptive_generation={"enabled": True},
        ),
        expressive=True,
    )

    # Join the room first: the frontend needs the state and the RPC methods
    # before the banker hears the first word.
    await ctx.connect()
    publisher = StatePublisher(ctx.room, store)
    ctx.add_shutdown_callback(publisher.aclose)

    @ctx.room.local_participant.register_rpc_method("warren.request_state")
    async def request_state(data: rtc.RpcInvocationData) -> str:
        publisher.publish()
        return str(store.state.rev)

    @ctx.room.local_participant.register_rpc_method("warren.set_stage")
    async def set_stage(data: rtc.RpcInvocationData) -> str:
        stage: Stage = json.loads(data.payload or "{}").get("stage")
        if stage not in AGENTS:
            raise rtc.RpcError(code=1, message=f"unknown stage {stage!r}")
        if stage != store.state.stage:
            # The banker clicked another stage: stop talking and switch now.
            store.set_stage(stage)
            await follow()
        return stage

    async def follow(brief: str | None = None) -> None:
        """After the banker moved the review by hand: stop talking, then speak from where it now stands."""
        with contextlib.suppress(RuntimeError):
            await session.interrupt()
        agent = session.current_agent
        state = store.state
        if (
            getattr(agent, "stage", None) != state.stage
            or getattr(agent, "mode", None) != state.mode
        ):
            prep.stage_ready.clear()
            session.update_agent(make_agent(state.stage, prep))
        elif state.mode == "guided":
            speak_unprompted(session, prep, brief or step_brief(store))

    @ctx.room.local_participant.register_rpc_method("warren.finish_step")
    async def finish_step(data: rtc.RpcInvocationData) -> str:
        outcome = json.loads(data.payload or "{}").get("outcome")
        if outcome not in ("answered", "for_meeting", "dismissed"):
            raise rtc.RpcError(code=1, message=f"unknown outcome {outcome!r}")
        closed = store.current_step
        store.finish_step(outcome)
        # Warren was not answered: tell it how the step ended, or it acts on its own question.
        await follow(after_button(store, closed, outcome))
        return store.state.current_step_id or ""

    @ctx.room.local_participant.register_rpc_method("warren.go_to_step")
    async def go_to_step(data: rtc.RpcInvocationData) -> str:
        payload = json.loads(data.payload or "{}")
        if payload.get("previous"):
            store.previous_step()
        else:
            try:
                store.go_to_step(payload.get("stepId"))
            except LookupError:
                raise rtc.RpcError(code=1, message="unknown step") from None
        await follow()
        return store.state.current_step_id or ""

    @ctx.room.local_participant.register_rpc_method("warren.set_mode")
    async def set_mode(data: rtc.RpcInvocationData) -> str:
        mode = json.loads(data.payload or "{}").get("mode")
        if mode not in ("guided", "listening"):
            raise rtc.RpcError(code=1, message=f"unknown mode {mode!r}")
        if mode != store.state.mode:
            store.set_mode(mode)
            await follow()
        return mode

    @ctx.room.local_participant.register_rpc_method("warren.set_scenario")
    async def set_scenario(data: rtc.RpcInvocationData) -> str:
        scenario = json.loads(data.payload or "{}").get("scenario")
        if scenario not in (None, "death"):
            raise rtc.RpcError(code=1, message=f"unknown scenario {scenario!r}")
        store.set_scenario(scenario)
        return scenario or ""

    publisher.publish()

    await session.start(
        agent=make_agent(store.state.stage, prep, first=True),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            video_input=True,
            text_input=room_io.TextInputOptions(text_input_cb=on_chat_text),
            audio_input=room_io.AudioInputOptions(
                noise_cancellation=ai_coustics.audio_enhancement(
                    model=ai_coustics.EnhancerModel.QUAIL_VF_S
                ),
            ),
        ),
    )


if __name__ == "__main__":
    cli.run_app(server)
