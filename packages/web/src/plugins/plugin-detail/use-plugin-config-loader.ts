/**
 * 插件配置拉取（带代数并发保护）：快速切换插件时迟到的旧响应不得写入新插件配置或状态。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { pluginsApi, type PluginConfigResponse } from '../../lib/api.js'

export interface PluginConfigLoader {
  config: (PluginConfigResponse & { pluginId: string }) | null
  loading: boolean
  error: string | null
  reload: (pluginId: string) => Promise<void>
}

export function usePluginConfigLoader(open: boolean, pluginId: string | undefined): PluginConfigLoader {
  const [config, setConfig] = useState<(PluginConfigResponse & { pluginId: string }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const generationRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      generationRef.current += 1
    }
  }, [])

  const reload = useCallback(async (id: string) => {
    const generation = ++generationRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await pluginsApi.getConfig(id)
      if (!mountedRef.current || generationRef.current !== generation) return
      setConfig({ ...result, pluginId: id })
    } catch (err) {
      if (!mountedRef.current || generationRef.current !== generation) return
      setConfig(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mountedRef.current && generationRef.current === generation) {
        setLoading(false)
      }
    }
  }, [])

  // 切换插件或开关抽屉：清空旧配置，打开时按当前插件重新拉取。
  useEffect(() => {
    generationRef.current += 1
    setConfig(null)
    setError(null)
    if (open && pluginId) {
      void reload(pluginId)
    } else {
      setLoading(false)
    }
  }, [open, pluginId, reload])

  return { config, loading, error, reload }
}
