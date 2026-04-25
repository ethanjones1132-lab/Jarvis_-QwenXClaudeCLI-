import 'react';

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': {
        children?: React.ReactNode;
        style?: any;
        [key: string]: any;
      };
      'ink-text': {
        children?: React.ReactNode;
        style?: any;
        [key: string]: any;
      };
      'ink-virtual-text': {
        children?: React.ReactNode;
        [key: string]: any;
      };
    }
  }

  // Internal flags used throughout the March 31st leak
  var __DEV__: boolean;
  var __CI__: boolean;
  var __TEST__: boolean;
}

export {};
