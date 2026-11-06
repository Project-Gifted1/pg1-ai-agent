"""Drive PG1's /api/a2a with the official A2A Python SDK (a2a-sdk on PyPI).

Usage: python official_a2a_client.py <base-url> [1.0|0.3 ...]

For each protocol version: fetch the agent card with the SDK's card
resolver, keep only that version's JSON-RPC interface (so the SDK's own
ClientFactory picks its 1.0 transport or its 0.3 compat transport), then:
  1. send a plain text message (PG1's free reply)  -> expect a completed Task
  2. call a paid skill without payment (X-Free-Tier: 0)
     -> expect an input-required Task carrying the x402 PaymentRequired
  3. GetTask on an unknown id                       -> expect TaskNotFoundError
  4. call an unknown skill                          -> expect an error raised
     by the SDK (not a parse failure)
Prints a readable transcript and, last, one JSON line {"ok": bool, ...}.
Exits 1 if any check fails.
"""

import asyncio
import json
import sys
import uuid

import httpx
from google.protobuf import json_format
from importlib.metadata import version as _pkg_version

from a2a.client import A2ACardResolver, ClientConfig, ClientFactory
from a2a.client.client import ClientCallContext
from a2a.types import a2a_pb2 as pb


def text_message(text):
    return pb.Message(message_id=str(uuid.uuid4()), role=pb.Role.ROLE_USER, parts=[pb.Part(text=text)])


def skill_message(skill, arguments):
    part = json_format.ParseDict({'data': {'skill': skill, 'arguments': arguments}, 'mediaType': 'application/json'}, pb.Part())
    return pb.Message(message_id=str(uuid.uuid4()), role=pb.Role.ROLE_USER, parts=[part])


async def send(client, message, headers=None):
    context = ClientCallContext(service_parameters=headers) if headers else None
    events = []
    async for event in client.send_message(pb.SendMessageRequest(message=message), context=context):
        events.append(event)
    return events


def task_of(events):
    for event in events:
        if event.HasField('task'):
            return event.task
    raise AssertionError(f'no task in the SDK response: {events!r}')


def first_text(task):
    for part in task.status.message.parts:
        if part.text:
            return part.text.splitlines()[0]
    return ''


async def run_version(base, version, out):
    results = {}
    async with httpx.AsyncClient(timeout=30) as http:
        card = await A2ACardResolver(http, base).get_agent_card()
    out(f'[{version}] card: {card.name} v{card.version}; interfaces '
        + ', '.join(f'{i.protocol_binding} {i.protocol_version}' for i in card.supported_interfaces))
    kept = [i for i in card.supported_interfaces if i.protocol_version == version]
    del card.supported_interfaces[:]
    card.supported_interfaces.extend(kept)
    client = ClientFactory(ClientConfig(streaming=False)).create(card)
    out(f'[{version}] SDK transport: {type(client._transport).__name__}')
    try:
        task = task_of(await send(client, text_message('Hello, what can you do?')))
        state = pb.TaskState.Name(task.status.state)
        out(f'[{version}] plain text -> Task {task.id} state={state}; '
            f'artifacts={[a.name for a in task.artifacts]}; reply="{first_text(task)}"')
        results['plain_text'] = state == 'TASK_STATE_COMPLETED' and bool(task.artifacts)

        task = task_of(await send(client, skill_message('get_threat_actor_profile', {'actor_name': 'APT29'}), {'X-Free-Tier': '0'}))
        state = pb.TaskState.Name(task.status.state)
        meta = json_format.MessageToDict(task.status.message.metadata)
        required = meta.get('x402.payment.required') or {}
        accepts = (required.get('accepts') or [{}])[0]
        out(f'[{version}] paid skill unpaid -> Task {task.id} state={state}; '
            f'x402.payment.status={meta.get("x402.payment.status")}; x402Version={required.get("x402Version")}; '
            f'accepts[0]={{scheme: {accepts.get("scheme")}, network: {accepts.get("network")}, amount: {accepts.get("amount")}}}')
        results['paid_unpaid'] = state == 'TASK_STATE_INPUT_REQUIRED' and meta.get('x402.payment.status') == 'payment-required' and bool(accepts.get('payTo'))

        try:
            await client.get_task(pb.GetTaskRequest(id=str(uuid.uuid4())))
            out(f'[{version}] GetTask unknown id -> no error (unexpected)')
            results['get_task_not_found'] = False
        except Exception as err:  # noqa: BLE001 - the SDK's typed error is what we check
            out(f'[{version}] GetTask unknown id -> {type(err).__name__}: {err}')
            results['get_task_not_found'] = type(err).__name__ == 'TaskNotFoundError'

        try:
            await send(client, skill_message('no_such_skill', {}))
            out(f'[{version}] unknown skill -> no error (unexpected)')
            results['unknown_skill_error'] = False
        except Exception as err:  # noqa: BLE001
            out(f'[{version}] unknown skill -> {type(err).__name__}: {str(err)[:160]}')
            # 1.0: the typed A2A error. 0.3: unchanged (HTTP 400, raised by the SDK as an HTTP error).
            results['unknown_skill_error'] = (type(err).__name__ == 'InvalidParamsError') if version == '1.0' else ('400' in str(err) or type(err).__name__ == 'InvalidParamsError')
    except Exception as err:  # noqa: BLE001
        out(f'[{version}] FAILED: {type(err).__name__}: {err}')
        results['exception'] = False
    finally:
        await client.close()
    return results


async def main():
    base = sys.argv[1]
    versions = sys.argv[2:] or ['1.0', '0.3']
    print(f'a2a-sdk {_pkg_version("a2a-sdk")} (official A2A Python SDK)', flush=True)
    summary = {}
    for version in versions:
        summary[version] = await run_version(base, version, lambda line: print(line, flush=True))
    ok = all(all(r.values()) and r for r in summary.values())
    print(json.dumps({'ok': ok, 'results': summary}))
    sys.exit(0 if ok else 1)


asyncio.run(main())
