import { useState } from 'react';

interface InlineSelectProps {
  options: string[];
  placeholder?: string;
  onConfirm: (value: string) => void;
  disabled?: boolean;
  label?: string;
}

const InlineSelect = ({ options, placeholder = 'Select an option', onConfirm, disabled, label }: InlineSelectProps) => {
  const [value, setValue] = useState('');

  return (
    <div className="mt-3 space-y-2">
      {label && <label className="text-xs font-medium text-muted-foreground">{label}</label>}
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </div>
  );
};

interface InlineSelectWithConfirmProps extends InlineSelectProps {}

export const InlineSelectWithConfirm = ({ options, placeholder, onConfirm, disabled, label }: InlineSelectWithConfirmProps) => {
  const [value, setValue] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const handleConfirm = () => {
    if (value) {
      setConfirmed(true);
      onConfirm(value);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      {label && <label className="text-xs font-medium text-muted-foreground">{label}</label>}
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={disabled || confirmed}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50"
      >
        <option value="">{placeholder || 'Select an option'}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      {!confirmed && (
        <button
          onClick={handleConfirm}
          disabled={!value || disabled}
          className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm
        </button>
      )}
      {confirmed && (
        <p className="text-xs text-muted-foreground">✓ Selected: {value}</p>
      )}
    </div>
  );
};

export const DualInlineSelect = ({ options1, options2, onConfirm, disabled }: {
  options1: string[];
  options2: string[];
  onConfirm: (v1: string, v2: string) => void;
  disabled?: boolean;
}) => {
  const [v1, setV1] = useState('');
  const [v2, setV2] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  const handleConfirm = () => {
    if (v1 && v2) {
      setConfirmed(true);
      onConfirm(v1, v2);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <label className="text-xs font-medium text-muted-foreground">Policy 1</label>
      <select value={v1} onChange={(e) => setV1(e.target.value)} disabled={disabled || confirmed}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50">
        <option value="">Select first policy</option>
        {options1.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <label className="text-xs font-medium text-muted-foreground">Policy 2</label>
      <select value={v2} onChange={(e) => setV2(e.target.value)} disabled={disabled || confirmed}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary disabled:opacity-50">
        <option value="">Select second policy</option>
        {options2.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {!confirmed && (
        <button onClick={handleConfirm} disabled={!v1 || !v2 || disabled}
          className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed">
          Confirm
        </button>
      )}
      {confirmed && <p className="text-xs text-muted-foreground">✓ Comparing: {v1} vs {v2}</p>}
    </div>
  );
};

export default InlineSelect;
