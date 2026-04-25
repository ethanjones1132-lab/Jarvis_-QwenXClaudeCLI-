export function shouldLoadHeadlessPlugins(params: {
  bareMode: boolean
}): boolean {
  return !params.bareMode
}
