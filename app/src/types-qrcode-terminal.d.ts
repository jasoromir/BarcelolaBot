declare module 'qrcode-terminal' {
  export function generate(input: string, opts?: { small?: boolean }, cb?: (qr: string) => void): void;
  export function setErrorLevel(level: 'L' | 'M' | 'Q' | 'H'): void;
}
