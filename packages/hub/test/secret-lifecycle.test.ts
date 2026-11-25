/**
 * SecretStash 全局脱敏与插件配置动态机密隔离回归测试：
 * - SecretStash：全局注册脱敏（含跨 chunk KMP 流式脱敏、最长前缀优先与 clear 释放）；
 * - 插件配置 HTTP 在重启与停用时均隐藏动态机密并保持已声明配置掩码。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHubHandler, CredentialService, SecretStash } from '@helmx/kernel'
import { createHubTestApp, useTempDir } from './helpers/hub-test-env.js'

test('SecretStash 全局脱敏：支持直接脱敏、跨 chunk 流式脱敏与 clear 释放', { timeout: 60_000 }, () => {
  const stash = new SecretStash()
  stash.addRedaction('tok-abc-123')
  assert.equal(stash.redact('leak: tok-abc-123'), 'leak: [REDACTED]')

  const stream = stash.createStreamingRedactor()
  const out = stream.push('prefix tok-abc-') + stream.push('123 tail') + stream.flush()
  assert.equal(out, 'prefix [REDACTED] tail')

  stash.clear()
  assert.equal(stash.redact('leak: tok-abc-123'), 'leak: tok-abc-123')
})

test('插件配置 HTTP 在重启与停用时均隐藏动态机密并保持已声明配置掩码', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-config-namespace-')
  const pluginId = 'test:dynamic-credentials'
  const dynamicSecret = 'dynamic-hook-signing-key-7e4a'
  const configSecret = 'declared-config-key-94b2'
  const credentials = new CredentialService(dataDir)
  await credentials.setPluginSecret(pluginId, 'webhook:demo', dynamicSecret)
  await credentials.setPluginSecret(pluginId, 'apiKey', configSecret)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    try {
      await app.kernel.plugins.register({
        id: pluginId,
        definePlugin(ctx) {
          ctx.configSchema({
            apiKey: { type: 'string', secret: true },
            retries: { type: 'number', default: 3 },
          })
        },
      }, { enabled: false })
      const credential = app.kernel.auth.createProcessToken()
      try {
        const handler = createHubHandler(app.kernel)
        const response = await handler(new Request(`http://localhost/api/plugins/${encodeURIComponent(pluginId)}/config`, {
          headers: { authorization: `Bearer ${credential.token}` },
        }))
        assert.equal(response.status, 200)
        const body = await response.text()
        assert.ok(!body.includes(dynamicSecret) && !body.includes('webhook:demo') && !body.includes(configSecret))
        const parsed = JSON.parse(body) as { values: Record<string, unknown> }
        assert.equal(parsed.values.apiKey, '******')
        assert.equal(Object.hasOwn(parsed.values, 'webhook:demo'), false)
      } finally {
        credential.dispose()
      }
    } finally {
      await app.close()
    }
  }
})
