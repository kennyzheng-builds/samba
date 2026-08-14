import { application } from '@application'
import { dialog, shell } from 'electron'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `t` pulls in i18n + preference machinery that isn't initialized under test; the
// dialog title it produces is irrelevant to these contracts, so stub it to the key.
vi.mock('@main/i18n', () => ({ t: (key: string) => key }))

import { fileStorage } from '../FileStorage'

const event = {} as Electron.IpcMainInvokeEvent

describe('FileStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('save', () => {
    it('returns null (does not throw) when the save dialog is canceled', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: true, filePath: undefined } as never)
      await expect(fileStorage.save(event, 'note.md', 'content')).resolves.toBeNull()
    })

    it('returns null when the dialog resolves without a file path', async () => {
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: '' } as never)
      await expect(fileStorage.save(event, 'note.md', 'content')).resolves.toBeNull()
    })
  })

  // resolveHomeRelativeFilePath is module-private; exercise it through showInFolder,
  // which throws with the *resolved* path when the target is missing.
  describe('resolveHomeRelativeFilePath', () => {
    it('expands a ~/-prefixed path against the home directory', async () => {
      await expect(fileStorage.showInFolder(event, '~/Documents/x.txt')).rejects.toThrow(
        path.join('/mock/sys.home', 'Documents', 'x.txt')
      )
    })

    it('leaves a path without the ~/ prefix unchanged', async () => {
      await expect(fileStorage.showInFolder(event, '/no/such/path/x.txt')).rejects.toThrow('/no/such/path/x.txt')
    })
  })

  describe('createTempFile', () => {
    let tempRoot: string

    beforeEach(() => {
      tempRoot = path.join(os.tmpdir(), `filestorage-temp-root-${uniqueId()}`)
      vi.mocked(application.getPath).mockImplementation((key: string) => {
        if (key !== 'app.temp') return `/mock/${key}`
        // Mirrors the volatile auto-ensure in Application.getPath: best-effort mkdir on
        // every lookup, failure swallowed, path handed back either way.
        try {
          fs.mkdirSync(tempRoot, { recursive: true })
        } catch {
          // matches production: a lookup never fails on an unwritable temp dir
        }
        return tempRoot
      })
    })

    afterEach(() => {
      fs.rmSync(tempRoot, { recursive: true, force: true })
    })

    it('fails with the reason the temp dir is unusable instead of handing out the path', async () => {
      // The persistent failures — a stray regular file squatting the temp dir name, a
      // read-only or permission-denied temp root — survive restarts and reinstalls. The
      // path lookup swallows them, so without this the renderer only ever saw an ENOENT
      // on `temp_file_<uuid>_image.png` and no way to tell what to fix.
      fs.writeFileSync(tempRoot, 'not a directory')

      await expect(fileStorage.createTempFile(event, 'image.png')).rejects.toThrow(tempRoot)
    })

    it('survives the temp dir being reaped between createTempFile and the write', async () => {
      // The OS temp reaper (and Windows cleanup utilities) delete the app temp dir while
      // Cherry runs, and handing out the path is a separate IPC round-trip from writing
      // it. A path into a directory that no longer exists fails the write with ENOENT —
      // which is what turned a pasted clipboard image into a bare "file processing error".
      const target = await fileStorage.createTempFile(event, 'image.png')
      fs.rmSync(tempRoot, { recursive: true, force: true })

      await fileStorage.writeFile(event, target, 'pasted')

      expect(fs.readFileSync(target, 'utf-8')).toBe('pasted')
    })

    it('leaves the temp dir alone for a write that lands somewhere else', async () => {
      // `writeFile` is the general file-write IPC. Resolving the volatile temp key on
      // every call would make each unrelated write re-create the temp dir — a synchronous
      // mkdir in the main process for writes that have nothing to do with it.
      const elsewhere = path.join(os.tmpdir(), `filestorage-elsewhere-${uniqueId()}.txt`)

      try {
        await fileStorage.writeFile(event, elsewhere, 'content')

        expect(fs.readFileSync(elsewhere, 'utf-8')).toBe('content')
        expect(fs.existsSync(tempRoot)).toBe(false)
      } finally {
        fs.rmSync(elsewhere, { force: true })
      }
    })

    it('does not create missing parent directories for writes outside the temp dir', async () => {
      // Only app.temp is known to vanish under a running app. Everywhere else a missing
      // parent still surfaces as an error instead of a silently materialized tree.
      const outside = path.join(os.tmpdir(), `filestorage-outside-${uniqueId()}`, 'note.md')

      await expect(fileStorage.writeFile(event, outside, 'x')).rejects.toThrow(/ENOENT/)
    })
  })

  describe('writeFile', () => {
    let tmpFile: string

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `filestorage-test-${uniqueId()}.txt`)
    })

    afterEach(() => {
      fs.rmSync(tmpFile, { force: true })
    })

    it('writes the given content', async () => {
      await fileStorage.writeFile(event, tmpFile, 'content')
      expect(fs.readFileSync(tmpFile, 'utf-8')).toBe('content')
    })
  })

  describe('deleteExternalFile', () => {
    let tmpFile: string

    beforeEach(() => {
      tmpFile = path.join(os.tmpdir(), `filestorage-delete-test-${uniqueId()}.md`)
      fs.writeFileSync(tmpFile, 'content')
      vi.mocked(shell.trashItem).mockResolvedValue(undefined)
    })

    afterEach(() => {
      fs.rmSync(tmpFile, { force: true })
    })

    it('normalizes the path before passing it to the platform trash API', async () => {
      const portablePath = tmpFile.replace(/\\/g, '/')

      await fileStorage.deleteExternalFile(event, portablePath)

      expect(shell.trashItem).toHaveBeenCalledWith(tmpFile)
    })

    it('normalizes Windows paths without relying on the test host platform', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      vi.spyOn(fs, 'existsSync').mockReturnValue(true)

      await fileStorage.deleteExternalFile(event, 'C:/Users/test/Notes/note.md')

      expect(shell.trashItem).toHaveBeenCalledWith('C:\\Users\\test\\Notes\\note.md')
    })

    it('does not invoke the trash API for an empty path', async () => {
      await fileStorage.deleteExternalFile(event, '')

      expect(shell.trashItem).not.toHaveBeenCalled()
    })
  })

  describe('deleteExternalDir', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filestorage-delete-dir-test-'))
      vi.mocked(shell.trashItem).mockResolvedValue(undefined)
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('normalizes the path before passing it to the platform trash API', async () => {
      const portablePath = tmpDir.replace(/\\/g, '/')

      await fileStorage.deleteExternalDir(event, portablePath)

      expect(shell.trashItem).toHaveBeenCalledWith(tmpDir)
    })

    it('does not invoke the trash API for an empty path', async () => {
      await fileStorage.deleteExternalDir(event, '')

      expect(shell.trashItem).not.toHaveBeenCalled()
    })
  })
})

function uniqueId(): string {
  return `${process.pid}-${Math.floor(Math.random() * 1e9)}`
}
