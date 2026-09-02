'use client';

import React, { useState } from 'react';

export default function VoiceButton({ text }: { text: string }) {
  const [isPlaying, setIsPlaying] = useState(false);

  const playPG1Voice = async () => {
    if (!text || isPlaying) return;
    
    setIsPlaying(true);
    
    try {
      const response = await fetch('/api/media/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: 'en-US-GuyNeural' }),
      });

      if (!response.ok) throw new Error('TTS Request Failed');

      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);

      audio.onended = () => setIsPlaying(false);
      await audio.play();
    } catch (error) {
      console.error('PG1 Voice Error:', error);
      setIsPlaying(false);
    }
  };

  return (
    <button
      onClick={playPG1Voice}
      disabled={isPlaying}
      className="ml-3 px-3 py-1 bg-emerald-900/30 border border-emerald-500/30 hover:bg-emerald-800/50 text-emerald-400 text-sm rounded-md transition-colors disabled:opacity-50"
      title="Play PG1 Voice"
    >
      {isPlaying ? '🔊 Speaking...' : '🗣️ Speak'}
    </button>
  );
}
