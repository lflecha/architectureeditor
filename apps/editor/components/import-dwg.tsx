'use client'

import { convertDwgToPascal } from '@pascal-app/dwg-converter'
import { applySceneGraphToEditor } from '@pascal-app/editor'
import { useCallback, useEffect, useRef, useState } from 'react'

type Status = { kind: 'idle' | 'working' | 'done' | 'error'; message: string }

async function importBuffer(buffer: ArrayBuffer): Promise<string> {
  const result = await convertDwgToPascal(buffer, { name: 'Imported DWG' })
  applySceneGraphToEditor({
    nodes: result.nodes as Record<string, unknown>,
    rootNodeIds: result.rootNodeIds,
  } as never)
  const s = result.stats
  return `${s.walls} walls · ${s.columns} columns · ${s.doors} doors · ${s.windows} windows · ${s.balustrades} balustrades`
}

/**
 * Minimal proof-of-concept control: pick a .dwg, parse it in-browser (LibreDWG
 * WASM), map it to Pascal nodes and load the scene. Also exposes a dev-only
 * `window.pascalImportDwgFromUrl(url)` helper for automated verification.
 */
export function ImportDwgButton() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle', message: '' })

  const runImport = useCallback(async (buffer: ArrayBuffer) => {
    setStatus({ kind: 'working', message: 'Converting DWG…' })
    try {
      const summary = await importBuffer(buffer)
      setStatus({ kind: 'done', message: summary })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }, [])

  useEffect(() => {
    if (process.env.NODE_ENV === 'production') return
    ;(window as unknown as { pascalImportDwgFromUrl?: (url: string) => Promise<string> })
      .pascalImportDwgFromUrl = async (url: string) => {
      const res = await fetch(url)
      const buf = await res.arrayBuffer()
      await runImport(buf)
      return status.message
    }
  }, [runImport, status.message])

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      const buf = await file.arrayBuffer()
      await runImport(buf)
    },
    [runImport],
  )

  return (
    <div className="pointer-events-auto flex items-center gap-2">
      <input
        accept=".dwg"
        className="hidden"
        onChange={onFile}
        ref={inputRef}
        type="file"
      />
      <button
        className="rounded-md border border-border/50 bg-background/80 px-3 py-1.5 font-medium text-sm shadow-sm backdrop-blur transition-colors hover:bg-accent"
        onClick={() => inputRef.current?.click()}
        type="button"
      >
        Import DWG
      </button>
      {status.kind !== 'idle' && (
        <span
          className={
            status.kind === 'error'
              ? 'text-red-500 text-xs'
              : status.kind === 'done'
                ? 'text-green-600 text-xs'
                : 'text-muted-foreground text-xs'
          }
        >
          {status.message}
        </span>
      )}
    </div>
  )
}
