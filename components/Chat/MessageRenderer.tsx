import React from 'react';
import { VideoPlayer } from './VideoPlayer';

interface MessageRendererProps {
  content: string;
}

export const MessageRenderer: React.FC<MessageRendererProps> = ({ content }) => {
  const videoUrlMatch = content.match(/(https:\/\/[^\s]+?\.(mp4|mov|webm)(?:\?[^\s]*)?)/i);

  if (videoUrlMatch) {
    const videoUrl = videoUrlMatch[1];
    const textWithoutUrl = content.replace(videoUrl, '');

    return (
      <div>
        {textWithoutUrl && <p style={{ whiteSpace: 'pre-wrap' }}>{textWithoutUrl}</p>}
        <VideoPlayer src={videoUrl} />
      </div>
    );
  }

  return <div style={{ whiteSpace: 'pre-wrap' }}>{content}</div>;
};