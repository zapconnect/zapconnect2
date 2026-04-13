// src/utils/withTimeout.ts
// Envelopa uma Promise com timeout; não cancela a operação subjacente, mas libera o fluxo.

export async function withTimeout<T>(
  promise: Promise<T>,
  ms = 12_000,
  label = "operação"
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timeout (${label}) após ${ms}ms`)),
        ms
      );
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
