declare const Bun: any
declare const MACRO: any

declare module 'bun:bundle' {
  export function feature(...args: any[]): any
}

declare module 'react/compiler-runtime' {
  export const c: any
}

declare module 'qrcode' {
  export function toString(...args: any[]): any
  const qrcode: any
  export default qrcode
}
