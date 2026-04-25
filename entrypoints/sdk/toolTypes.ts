export interface ToolInput {
  [key: string]: any;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ToolResult {
  content: Array<{ 
    type: 'text'; 
    text: string; 
  } | {
    type: 'image';
    source: any;
  }>;
  isError?: boolean;
}

export type ToolUseHandler = (input: ToolInput) => Promise<ToolResult>;
