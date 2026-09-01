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
    </div>
  );
};