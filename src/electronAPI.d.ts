/** Typings for the preload-exposed API. */
export {};

declare global {
  /** A running Docker container, as reported by `docker ps`. */
  interface DockerService {
    id: string;
    name: string;
    image: string;
    state: string;
  }

  type DockerListResult = { services: DockerService[] } | { error: string };
  type DockerStartResult = { ok: true } | { error: string };

  interface ElectronAPI {
    isElectron: true;
    platform: NodeJS.Platform;
    getSidecarPort: () => Promise<number | null>;
    openSkyviewPopout: () => Promise<void>;
    openExternal: (url: string) => void;
    onSidecarReady: (cb: (payload: { port: number }) => void) => () => void;
    onCaptureGoto: (
      cb: (payload: { route: string }) => void,
    ) => () => void;
    captureReady: () => void;
    onRecordStart: (cb: () => void) => () => void;
    onRecordStop: (cb: () => void) => () => void;
    sendRecordChunk: (buf: ArrayBuffer) => void;
    sendRecordDone: () => void;
    sendRecordError: (message: string) => void;

    /** List running Docker containers (service log selector). */
    listDockerServices: () => Promise<DockerListResult>;
    /** Begin tailing `docker logs -f` for a container; chunks arrive via onDockerLogChunk. */
    startDockerLog: (container: string) => Promise<DockerStartResult>;
    /** Stop a tail started with startDockerLog. */
    stopDockerLog: (container: string) => void;
    /** Subscribe to log chunks for any active tail. Returns an unsubscribe fn. */
    onDockerLogChunk: (
      cb: (payload: { container: string; text: string }) => void,
    ) => () => void;
  }

  interface Window {
    electronAPI?: ElectronAPI;
  }
}
