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

  // 1. PG1 Neural Voice Integration
  const [ttsText, setTtsText] = useState("");
  const [ttsStatus, setTtsStatus] = useState<string>("");

  const handleNeuralVoiceSynthesis = async (text: string) => {
    try {
      setTtsStatus("PG1.Agent using Google TTS via Neural Protocol...");
      const response = await fetch("/api/google-tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, model: "en-US-Standard-D" }),
      });
      if (!response.ok) throw new Error("PG1 Neural Voice synthesis failed");
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.play();
      setTtsStatus("PG1.Agent Status: playing Neural Voice response");
    } catch (err: any) {
      console.error("PG1 Neural Voice error:", err);
      setTtsStatus("PG1.Sovereign Execution failed: " + err.message);
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
    let isActive = true;

    const bootstrapStream = async () => {
      try {
        const constraints: MediaStreamConstraints = {
          video: { facingMode: { ideal: "user" } },
          audio: true,
        };

        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!isActive) {
          newStream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = newStream;

        if (videoRef.current) {
          videoRef.current.srcObject = newStream;
          await videoRef.current.play().catch(() => {});
        }

        setError(null);
        setIsStreaming(true);
      } catch (err: any) {
        if (!isActive) return;
        console.error("Error accessing media:", err);
        setError(err.message || "Failed to access camera/microphone");
        setIsStreaming(false);
      }
    };

    void bootstrapStream();

    return () => {
      isActive = false;
      stopStream();
    };
  }, [stopStream]);

  return (
  <div className="flex flex-col items-center justify-center min-h-screen p-4 bg-slate-950 text-white">
    <div className="w-full max-w-3xl bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl p-6">
        <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">PG1 Sovereign Agent Control Center</h1>
          <p className="text-sm text-slate-400 mt-1">PG1.Agent • PG1 Autonomous Core • Transparent media and Neural Voice controls</p>
        </div>
        <span className="text-xs px-2.5 py-1 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
          Sentinel Mode: <span className="font-semibold text-emerald-400 capitalize">{isStreaming ? "monitoring" : "standby"}</span>
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 text-sm">
        <div className="rounded-xl border border-slate-800 bg-slate-800/60 p-3">
          <p className="text-slate-400 text-xs uppercase tracking-[0.18em] mb-2">PG1.Agent Status</p>
          <p className="font-semibold">{isStreaming ? "Media stream active" : "Awaiting media authorization"}</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-800/60 p-3">
          <p className="text-slate-400 text-xs uppercase tracking-[0.18em] mb-2">Neural Protocol Status</p>
          <p className="font-semibold">{ttsStatus || "Idle — no Neural Voice execution active"}</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-800/60 p-3">
          <p className="text-slate-400 text-xs uppercase tracking-[0.18em] mb-2">Triple Verification Status</p>
          <p className="font-semibold">{error ? "Failure captured honestly" : "Standing by for verification"}</p>
        </div>
      </div>

      <div className="relative aspect-video w-full bg-black rounded-xl overflow-hidden mb-6 flex items-center justify-center border border-slate-800">
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
            <div className="absolute inset-0 flex items-center justify-center text-slate-500">
              PG1.Agent Status: camera and microphone offline
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-red-950/80 text-red-200 text-center">
              <p className="font-semibold">PG1.Sovereign Execution failed</p>
              <p className="text-sm opacity-80 mt-1">{error}</p>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-4 mb-6 bg-slate-800/50 p-4 rounded-xl border border-slate-700">
          <div>
            <h2 className="text-sm font-semibold mb-2 text-slate-200">Neural Protocol Status</h2>
            <p className="text-xs text-slate-400 mb-3">PG1.Agent can disclose third-party speech synthesis usage here. Current route uses Google TTS through a PG1 Neural Protocol.</p>
            <div className="flex gap-2">
              <input 
                type="text" 
                className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500"
                placeholder="Describe the voice response you want PG1.Agent to synthesize..."
                value={ttsText}
                onChange={(e) => setTtsText(e.target.value)}
              />
              <button 
                onClick={() => handleNeuralVoiceSynthesis(ttsText)}
                className="px-4 py-2 bg-sky-500 hover:bg-sky-400 rounded-lg font-medium text-sm text-slate-950 transition"
              >
                Authorize Execution
              </button>
            </div>
            {ttsStatus && <p className="text-xs text-sky-300 mt-2">{ttsStatus}</p>}
          </div>

          <div className="border-t border-slate-700 pt-4 flex items-center justify-between">
            <div className="text-sm">
              <p className="font-semibold text-slate-300">Autonomous Feedback Control Loop</p>
              <p className="text-xs text-slate-500">Voice capture remains transparent: recording state and base64 encoding events are logged to the browser console.</p>
            </div>
            {isRecordingAudio ? (
              <button 
                onClick={stopAudioRecording}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 rounded-lg font-medium text-sm transition animate-pulse"
              >
                Deny Operation
              </button>
            ) : (
              <button 
                onClick={startAudioRecording}
                disabled={!isStreaming}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg font-medium text-sm transition"
              >
                Request Modification
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 border-t border-slate-800 pt-6">
          <button
            onClick={toggleCameraFlip}
            disabled={!isStreaming}
            className="flex items-center gap-2 px-4 py-2 bg-slate-700 hover:bg-slate-600 active:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg shadow transition"
          >
            <span>Chron Protocol View Shift ({facingMode === "user" ? "Back" : "Front"})</span>
          </button>

          {isStreaming ? (
            <button
              onClick={stopStream}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-medium rounded-lg shadow transition"
            >
              Deny Operation
            </button>
          ) : (
            <button
              onClick={() => startStream(facingMode)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium rounded-lg shadow transition"
            >
              Authorize Execution
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
