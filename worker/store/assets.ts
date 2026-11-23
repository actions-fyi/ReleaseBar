// The static assets of the app: the files of dist/client.

export function fetchAsset(env: Env, request: Request): Promise<Response> {
  return env.ASSETS.fetch(request);
}
