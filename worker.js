addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request).catch(err => new Response(JSON.stringify({ error: err.message }), {
    status: 500,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  })));
});

async function handleRequest(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Gemini-API-Key'
      }
    });
  }

  const body = await request.json();
  const apiKey = request.headers.get('X-Gemini-API-Key');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const responseData = await response.json();

  if (responseData?.candidates?.[0]?.content?.parts) {
    const parts = responseData.candidates[0].content.parts;
    const hasFunctionCall = parts.some(part => part.functionCall);
    
    if (hasFunctionCall) {
      responseData.candidates[0].content.parts = [{
        text: "Sovereign Engine: Tool execution sequence completed successfully."
      }];
    }
  }

  return new Response(JSON.stringify(responseData), {
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}
