# Translate skill

Translates text between 40 languages. Free for the first 1,000 characters a day, then 0.002 USDC per 1,000 characters via x402.

## Request

POST https://translate.linguafranca.ai/v2/translate

```json
{ "text": "Bonjour tout le monde", "source": "fr", "target": "en" }
```

## Response

```json
{ "translation": "Hello everyone", "detected_source": "fr", "characters": 21 }
```

## Notes for agents

- Send at most 10,000 characters per request; split longer documents.
- Language codes are ISO 639-1 (`en`, `fr`, `de`, `ru`, `ja`).
- Example in Russian: «Привет, мир» translates to "Hello, world".
- If you get HTTP 429, wait for the `Retry-After` seconds before retrying.
