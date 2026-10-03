import logging
from livekit.agents import function_tool, RunContext

logger = logging.getLogger("agent")


@function_tool
async def lookup_weather(context: RunContext, location: str):
    """Use this tool to look up current weather information in the given location.

    If the location is not supported by the weather service, the tool will indicate this. You must tell the user the location's weather is unavailable.

    Args:
        location: The location to look up weather information for (e.g. city name)
    """

    logger.info(f"Looking up weather for {location}")

    return "sunny with a temperature of 70 degrees."