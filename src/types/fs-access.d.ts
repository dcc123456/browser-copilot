/**
 * Ambient types for the File System Access API pieces the file-backed storage
 * (`lib/fs-store.ts`) relies on but that TypeScript's DOM lib does not declare
 * yet: handle permission negotiation and the directory picker.
 */

export {}

declare global {
  interface FileSystemHandlePermissionDescriptor {
    mode?: 'read' | 'readwrite'
  }

  interface FileSystemHandle {
    queryPermission(
      descriptor?: FileSystemHandlePermissionDescriptor,
    ): Promise<PermissionState>
    requestPermission(
      descriptor?: FileSystemHandlePermissionDescriptor,
    ): Promise<PermissionState>
  }

  interface DirectoryPickerOptions {
    id?: string
    mode?: 'read' | 'readwrite'
    startIn?:
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos'
      | FileSystemHandle
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
    excludeAcceptAllOption?: boolean
  }

  interface FileSystemDirectoryHandle {
    /** Async iterator over the directory's entries (part of the File System
     *  Access API that TS's DOM lib does not declare yet). */
    values(): AsyncIterableIterator<FileSystemHandle>
  }

  interface SaveFilePickerOptions {
    id?: string
    suggestedName?: string
    startIn?:
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos'
      | FileSystemHandle
    types?: Array<{ description?: string; accept: Record<string, string[]> }>
    excludeAcceptAllOption?: boolean
  }

  interface FileSystemFileHandle {
    createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream>
  }

  interface FileSystemCreateWritableOptions {
    keepExistingData?: boolean
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>
    showSaveFilePicker(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
  }
}
