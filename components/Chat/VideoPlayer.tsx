import React from 'react';

interface VideoPlayerProps {
  src: string;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({ src }) => {
  return (
    <div style={{ width: '100%', borderRadius: '8px', overflow: 'hidden', marginTop: '10px', border: '1px solid rgba(212, 175, 55, 0.4)' }}>
      <video
        src={src}
        controls
        playsInline
        webkit-playsinline="true"
        preload="metadata"
        style={{ width: '100%', display: 'block', background: '#000' }}
      />
      <div style={{ padding: '8px', background: '#111', textAlign: 'center' }}>
        <a
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: '#d4af37', fontSize: '12px', textDecoration: 'none', fontWeight: 'bold' }}
        >
          Direct Playback / Stream Link
        </a>
      </div>
    </div>
  );
};