const TypingIndicator = () => (
  <div className="flex items-start gap-3 animate-fade-in">
    <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0">
      IA
    </div>
    <div className="chat-bubble-bot flex items-center py-3 px-5">
      <div className="dot-flashing">
        <span />
      </div>
    </div>
  </div>
);

export default TypingIndicator;
