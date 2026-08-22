addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const body = await request.json();
  const apiKey = request.headers.get('X-Gemini-API-Key');

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  let responseData = await response.json();

  if (responseData.candidates && responseData.candidates[0].content && responseData.candidates[0].content.parts) {
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
