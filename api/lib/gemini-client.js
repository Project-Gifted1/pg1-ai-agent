/**
 * Gemini API Client Module
 * Handles all interactions with Google's Gemini API
 * Includes retry logic, model fallback, and error handling
 */

class GeminiClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.models = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-flash-latest'];
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models';
  }

  /**
   * Send request to Gemini API with automatic model fallback
   */
  async sendRequest(prompt, systemInstruction, tools = [], options = {}) {
    for (const model of this.models) {
      try {
        return await this.sendToModel(model, prompt, systemInstruction, tools, options);
      } catch (err) {
        console.error(`Model ${model} failed:`, err.message);
        continue;
      }
    }
    throw new Error('All Gemini models failed');
  }

  /**
   * Send request to specific model
   */
  async sendToModel(model, prompt, systemInstruction, tools = [], options = {}) {
    const url = `${this.baseUrl}/${model}:generateContent?key=${this.apiKey}`;
    
    const payload = {
      systemInstruction: {
        parts: [{ text: systemInstruction }]
      },
      contents: [{ parts: [{ text: prompt }] }],
      tools,
      generationConfig: {
        temperature: options.temperature || 0.7,
        topP: options.topP || 0.95,
        maxOutputTokens: options.maxOutputTokens || 4096
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `API error: ${response.status}`);
    }

    return data;
  }

  /**
   * Continue conversation with function response
   */
  async continueWithFunctionResponse(
    originalPrompt,
    systemInstruction,
    conversationHistory,
    functionResponse,
    tools = [],
    options = {}
  ) {
    const model = options.model || this.models[0];
    const url = `${this.baseUrl}/${model}:generateContent?key=${this.apiKey}`;

    const contents = [
      { parts: [{ text: originalPrompt }] },
      ...conversationHistory,
      { parts: [{ functionResponse }] }
    ];

    const payload = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools,
      generationConfig: {
        temperature: options.temperature || 0.7,
        topP: options.topP || 0.95,
        maxOutputTokens: options.maxOutputTokens || 4096
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `API error: ${response.status}`);
    }

    return data;
  }

  /**
   * Extract text from response safely
   */
  extractText(response) {
    return response?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  }

  /**
   * Extract function call from response safely
   */
  extractFunctionCall(response) {
    return response?.candidates?.[0]?.content?.parts?.find(p => p.functionCall) || null;
  }
}

module.exports = GeminiClient;
