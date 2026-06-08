const isDev = process.env.NODE_ENV !== 'production';

function fmt(level: string, msg: string, data?: unknown): string {
  const ts = new Date().toISOString();
  const suffix = data !== undefined ? ' ' + JSON.stringify(data) : '';
  return `[${ts}] [${level}] ${msg}${suffix}`;
}

export const logger = {
  info: (msg: string, data?: unknown) => console.log(fmt('INFO', msg, data)),
  warn: (msg: string, data?: unknown) => console.warn(fmt('WARN', msg, data)),
  error: (msg: string, data?: unknown) => console.error(fmt('ERROR', msg, data)),
  debug: (msg: string, data?: unknown) => {
    if (isDev) console.debug(fmt('DEBUG', msg, data));
  },
};
