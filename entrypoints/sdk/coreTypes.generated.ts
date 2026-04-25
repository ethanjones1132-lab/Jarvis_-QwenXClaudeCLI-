export const AllModelNames = [
  "claude-3-7-sonnet-20250219", 
  "claude-3-5-sonnet-20241022", 
  "claude-3-opus-20240229",
  "claude-4-7-opus-preview",
  "capybara-alpha-8"
];
export type ModelName = typeof AllModelNames[number];
export const FEATURE_FLAGS = {
  KAIROS_ENABLED: true,
  BUDDY_SYSTEM_ENABLED: true,
  UNDERCOVER_MODE_AVAILABLE: true,
  DREAM_MODE_V2: true
};
