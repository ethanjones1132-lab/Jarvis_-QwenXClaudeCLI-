export type RuntimePlatform = 'windows' | 'macos' | 'linux' | 'unsupported';
export type RuntimeArch = 'x64' | 'arm64';

export interface RuntimeContext {
  platform: RuntimePlatform;
  arch: RuntimeArch;
  version: string;
  isWindows: boolean;
  isContainer: boolean;
  canExecute: boolean;
}

export const CURRENT_RUNTIME: RuntimeContext = {
  platform: 'windows',
  arch: 'x64',
  version: '1.3.11',
  isWindows: true,
  isContainer: false,
  canExecute: true
};
