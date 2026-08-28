class PG1VoicePlayer {
  constructor() {
    this.isPlaying = false;
    this.currentAudio = null;
  }

  buildBackendUrl(path) {
    if (window.PG1_BUILD_BACKEND_URL) {
      return window.PG1_BUILD_BACKEND_URL(path);
    }

    return path;
  }

  base64ToBlob(base64, mimeType = 'audio/mpeg') {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }

  async playVoice(text, context = 'neutral') {
    if (this.isPlaying || !text) return null;

    this.isPlaying = true;
    let objectUrl = null;
    try {
      const response = await fetch(this.buildBackendUrl('/api/media/voice'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, context })
      });

      if (!response.ok) throw new Error(`Voice API error: ${response.status}`);
      const data = await response.json();
      if (!data.audioBase64) throw new Error('Voice API did not return audio data');

      const blob = this.base64ToBlob(data.audioBase64, 'audio/mpeg');
      objectUrl = URL.createObjectURL(blob);
      const audioElement = document.getElementById('voice-output');
      const audio = audioElement || new Audio();
      audio.src = objectUrl;

      await audio.play();
      audio.onended = () => {
        URL.revokeObjectURL(objectUrl);
        this.isPlaying = false;
      };

      this.currentAudio = audio;
      return data;
    } catch (error) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      this.isPlaying = false;
      throw error;
    }
  }

  stop() {
    if (!this.currentAudio) return;
    this.currentAudio.pause();
    this.currentAudio.currentTime = 0;
    this.isPlaying = false;
  }

  async listVoices() {
    const response = await fetch(this.buildBackendUrl('/api/media/voice?action=list'));
    if (!response.ok) throw new Error(`Voice list failed: ${response.status}`);
    const data = await response.json();
    return data.voices || [];
  }
}

window.PG1Voice = new PG1VoicePlayer();
