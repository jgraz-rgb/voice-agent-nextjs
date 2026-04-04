const TypingIndicator = () => (
  <div className="flex items-start gap-3 animate-fade-in">
    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
      IA
    </div>
    <div className="chat-bubble-bot flex items-center gap-1.5 py-4 px-5">
      <span className="typing-dot" />
      <span className="typing-dot" />
      <span className="typing-dot" />
    </div>
  </div>
);

export default TypingIndicator;
