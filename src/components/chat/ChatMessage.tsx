import { ReactNode } from 'react';

export interface ChatMessageData {
  id: string;
  role: 'bot' | 'user';
  content?: string;
  richContent?: ReactNode;
}

interface ChatMessageProps {
  message: ChatMessageData;
}

const ChatMessage = ({ message }: ChatMessageProps) => {
  const isBot = message.role === 'bot';

  return (
    <div className={`flex items-start gap-3 animate-fade-in ${isBot ? '' : 'flex-row-reverse'}`}>
      {isBot && (
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
          IA
        </div>
      )}
      <div className={`max-w-[75%] ${isBot ? 'chat-bubble-bot' : 'chat-bubble-user'}`}>
        {message.content && (
          <div
            className="text-sm leading-relaxed [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:mt-2 [&_ul]:space-y-1 [&_strong]:font-semibold [&_table]:w-full [&_table]:mt-3 [&_th]:text-left [&_th]:pb-2 [&_th]:font-semibold [&_th]:text-xs [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground [&_td]:py-1.5 [&_td]:pr-4 [&_td]:text-sm [&_td]:border-b [&_td]:border-border/30"
            dangerouslySetInnerHTML={{ __html: message.content }}
          />
        )}
        {message.richContent}
      </div>
    </div>
  );
};

export default ChatMessage;
