# PG1's tools as OpenAI function tools.   pip install openai
from pg1_sdk import PG1Client
from pg1_sdk.frameworks import openai_function_tools

tools, run = openai_function_tools(PG1Client(), only=["preflight_check", "check_package"])
print([t["function"]["name"] for t in tools])
# Pass `tools` to the API; for each tool call: run(call.function.name, call.function.arguments)
