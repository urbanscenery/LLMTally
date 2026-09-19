export function parseAccountAttribute(dump: string): string | null {
  const match = /"acct"<blob>="((?:[^"\\]|\\.)*)"/.exec(dump);
  const value = match?.[1];
  return value === undefined || value.length === 0 ? null : value;
}

export function parseKeychainPasswordOutput(output: string): string | null {
  const hex = /^password: 0x([0-9A-F]+)(?: +"[\s\S]*")? *\n$/.exec(output)?.[1];
  if (hex !== undefined) {
    if (hex.length % 2 !== 0) {
      return null;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'));
    } catch (error) {
      if (error instanceof TypeError) {
        return null;
      }
      throw error;
    }
  }
  const quoted = /^password: "([\s\S]*)"\n$/.exec(output)?.[1];
  if (quoted !== undefined) {
    return quoted;
  }
  return output === 'password: \n' ? '' : null;
}
