"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";

export default function Client() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsStreaming(false);
  }, []);

  const startStream = useCallback(
    async (mode: "user" | "environment") => {
      stopStream();
      setError(null);

      try {
        const constraints: MediaStreamConstraints = {
          video: { facingMode: { ideal: mode } },
          audio: false,
        };

        const newStream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = newStream;

        if (videoRef.current) {
          videoRef.current.srcObject = newStream;
          await videoRef.current.play().catch(() => {});
        }

        setIsStreaming(true);
      } catch (err: any) {
        console.error("Error accessing camera:", err);
        setError(err.message || "Failed to access camera");
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
          <h1 className="text-xl font-bold tracking-tight">Camera Feed</h1>
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
              Camera is off
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-4 bg-red-950/80 text-red-200 text-center">
              <p className="font-semibold">Camera Error</p>
              <p className="text-sm opacity-80 mt-1">{error}</p>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3">
          <button
            onClick={toggleCameraFlip}
            disabled={!isStreaming}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 active:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg shadow transition"
            aria-label="Flip camera toggle"
            title="Toggle camera (Front / Back)"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 10c0-4.418-3.582-8-8-8s-8 3.582-8 8c0 2.2 0.89 4.19 2.34 5.65" />
              <polyline points="7 14 4 10 1 14" />
              <path d="M4 14c0 4.418 3.582 8 8 8s8-3.582 8-8c0-2.2-0.89-4.19-2.34-5.65" />
              <polyline points="17 10 20 14 23 10" />
            </svg>
            <span>Flip Camera ({facingMode === "user" ? "Back" : "Front"})</span>
          </button>

          {isStreaming ? (
            <button
              onClick={stopStream}
              className="px-4 py-2 bg-red-600 hover:bg-red-500 active:bg-red-700 text-white font-medium rounded-lg shadow transition"
            >
              Stop Camera
            </button>
          ) : (
            <button
              onClick={() => startStream(facingMode)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-medium rounded-lg shadow transition"
            >
              Start Camera
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
