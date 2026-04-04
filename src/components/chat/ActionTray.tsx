import { Sparkles, GitCompare, FileText, RotateCcw } from 'lucide-react';

interface ActionTrayProps {
  onAction: (action: 'pitch' | 'compare' | 'summarize') => void;
  disabled?: boolean;
  showRefresh?: boolean;
  onRefresh?: () => void;
  hideActions?: boolean;
}

const actions = [
  {
    id: 'pitch' as const,
    icon: Sparkles,
    title: 'Pitch a policy',
    desc: 'Pick a policy and I will craft a sales pitch for you within seconds!',
  },
  {
    id: 'compare' as const,
    icon: GitCompare,
    title: 'Compare policies',
    desc: 'Ask me for a comparison of benefits of 2 policies',
  },
  {
    id: 'summarize' as const,
    icon: FileText,
    title: 'Summarize a policy',
    desc: 'Choose a policy and ask me to summarize all of its benefits',
  },
];

const ActionTray = ({ onAction, disabled, showRefresh, onRefresh, hideActions }: ActionTrayProps) => (
  <div className="flex flex-col gap-2">
    {!hideActions && (
      <div className="flex gap-3 overflow-x-auto pb-1 px-1">
        {actions.map((a) => (
          <button
            key={a.id}
            disabled={disabled}
            onClick={() => onAction(a.id)}
            className="action-card flex-1 min-w-[180px] text-left flex flex-col gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <a.icon className={`w-4 h-4 ${disabled ? 'text-muted-foreground' : 'text-primary'}`} />
              <span className={`font-semibold text-sm ${disabled ? 'text-muted-foreground' : 'text-foreground'}`}>{a.title}</span>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">{a.desc}</p>
          </button>
        ))}
      </div>
    )}
    {showRefresh && onRefresh && (
      <button
        onClick={onRefresh}
        className="flex items-center gap-1.5 self-start px-3 py-1.5 rounded-lg text-xs font-medium text-primary hover:bg-primary/10 transition-colors"
      >
        <RotateCcw className="w-3.5 h-3.5" />
        New conversation
      </button>
    )}
  </div>
);

export default ActionTray;
