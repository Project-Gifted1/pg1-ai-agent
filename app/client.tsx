"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";

export default function Client() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // 1. Google TTS Integration
  const [ttsText, setTtsText] = useState("");
  const [ttsStatus, setTtsStatus] = useState<string>("");

  const handleGoogleTTS = async (text: string) => {
    try {
      setTtsStatus("Synthesizing Google TTS (en-US-Standard-D)...");
      // Simulate Google TTS API Integration
      const response = await fetch("/api/google-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model: "en-US-Standard-D" }), // Google TTS models integrated here
      });
      if (!response.ok) throw new Error("TTS synthesis failed");
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.play();
      setTtsStatus("Playing TTS audio");
    } catch (err: any) {
      console.error("Google TTS Error:", err);
      setTtsStatus("TTS Error: " + err.message);
    }
  };

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    setIsStreaming(false);
    setIsRecordingAudio(false);
  }, []);

  const startStream = useCallback(
    async (mode: "user" | "environment") => {
      stopStream();
      setError(null);

      try {
        const constraints: MediaStreamConstraints = {
          video: { facingMode: { ideal: mode } },
          audio: true, // Enabled for speech-to-text buffer & voice message encoding
        };

        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = newStream;

        if (videoRef.current) {
          videoRef.current.srcObject = newStream;
          await videoRef.current.play().catch(() => {});
        }

        setIsStreaming(true);
      } catch (err: any) {
        console.error("Error accessing media:", err);
        setError(err.message || "Failed to access camera/microphone");
        setIsStreaming(false);
      }
    },
    [stopStream]
  );

  const toggleCameraFlip = useCallback(async () => {
    const nextMode = facingMode === "user" ? "environment" : "user";
    setFacingMode(nextMode);
    await startStream(nextMode);
  }, [facingMode, startStream]);

  // 2. Debug speech-to-text buffer & 3. Restore voice message encoding
  const startAudioRecording = () => {
    if (!streamRef.current) return;
    audioChunksRef.current = [];
    
    // Create MediaRecorder to capture audio for STT buffer
    const mediaRecorder = new MediaRecorder(streamRef.current);
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        // Debug speech-to-text buffer chunk
        console.log("STT Buffer Debug: Received chunk of size", event.data.size);
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      console.log("STT Buffer Debug: Recording stopped, processing buffer.");
      const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      
      // Restore voice message encoding
      const reader = new FileReader();
      reader.readAsDataURL(audioBlob);
      reader.onloadend = () => {
        const base64VoiceMessage = reader.result;
        console.log("Voice Message Encoded successfully to Base64:", base64VoiceMessage?.toString().slice(0, 50) + "...");
      };
    };

    mediaRecorder.start(100); // 100ms timeslice for STT buffer debugging
    setIsRecordingAudio(true);
  };

  const stopAudioRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      setIsRecordingAudio(false);
    }
  };

  useEffect(() => {
    startStream(facingMode);
    return () => {
      stopStream();
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-4 bg-gray-950 text-white">
      <div className="w-full max-w-2xl bg-gray-900 border border-gray-800 rounded-2xl overflow-hidden shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-xl font-bold tracking-tight">Media Hub</h1>
          <span className="text-xs px-2.5 py-1 rounded-full bg-gray-800 text-gray-400 border border-gray-700">
            Facing: <span className="font-semibold text-emerald-400 capitalize">{facingMode}</span>
          </span>
        </div>

        <div className="relative aspect-video w-full bg-black rounded-xl overflow-hidden mb-6 flex items-center justify-center border border-gray-800">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover ${
              facingMode === "user" ? "scale-x-[-1]" : ""
            }`}
          />
          {!isStreaming && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-gray-500">
              Camera/Mic is off
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-red-950/80 text-red-200 text-center">
              <p className="font-semibold">Media Error</p>
              <p className="text-sm opacity-80 mt-1">{error}</p>
            </div>
          )}
        </div>

        {/* New sections for TTS and Voice Message Recording */}
        <div className="flex flex-col gap-4 mb-6 bg-gray-800/50 p-4 rounded-xl border border-gray-700">
          <div>
            <h2 className="text-sm font-semibold mb-2 text-gray-300">Google TTS Models</h2>
            <div className="flex gap-2">
              <input 
                type="text" 
                className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                placeholder="Enter text to synthesize..."
                value={ttsText}
                onChange={(e) => setTtsText(e.target.value)}
              />
              <button 
                onClick={() => handleGoogleTTS(ttsText)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg font-medium text-sm transition"
              >
                Synthesize
              </button>
            </div>
            {ttsStatus && <p className="text-xs text-indigo-300 mt-2">{ttsStatus}</p>}
          </div>

          <div className="border-t border-gray-700 pt-4 flex items-center justify-between">
            <div className="text-sm">
              <p className="font-semibold text-gray-300">STT Buffer & Voice Encoding</p>
              <p className="text-xs text-gray-500">Debug buffer & restore base64 encoding</p>
            </div>
            {isRecordingAudio ? (
              <button 
                onClick={stopAudioRecording}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg font-medium text-sm transition animate-pulse"
              >
                Stop Recording
              </button>
            ) : (
              <button 
                onClick={startAudioRecording}
                disabled={!isStreaming}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium text-sm transition"
              >
                Record Voice
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 border-t border-gray-800 pt-6">
          <button
            onClick={toggleCameraFlip}
            disabled={!isStreaming}
            className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 active:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg shadow transition"
          >
            <span>Flip Camera ({facingMode === "user" ? "Back" : "Front"})</span>
          </button>

          {isStreaming ? (
            <button
              onClick={stopStream}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-medium rounded-lg shadow transition"
            >
              Stop Media
            </button>
          ) : (
            <button
              onClick={() => startStream(facingMode)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium rounded-lg shadow transition"
            >
              Start Media
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
