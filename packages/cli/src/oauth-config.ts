/**
 * OAuth連携（`o2n login`）の設定。client_idは秘密情報ではないため公開コードに含めてよい
 * （client_secretはCloudflare Worker側にのみ保持され、ここには一切含まれない）。
 * デプロイ後、services/auth-proxy/README.md の手順にしたがってこの2値を実際の値に更新すること。
 */
export const AUTH_PROXY_URL = 'https://o2n-auth-proxy.workflow-lab.workers.dev';
export const NOTION_OAUTH_CLIENT_ID = '3a1d872b-594c-8121-94df-0037908f8601';
