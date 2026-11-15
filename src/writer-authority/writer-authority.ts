export class WriterAuthority {
  lossSequence = 0;
  private generation: bigint | null = null;
  private highestGeneration = -1n;
  readiness() {
    return this.generation === null
      ? ({ ready: false, code: "writer_ownership_unavailable" } as const)
      : ({ ready: true, generation: this.generation } as const);
  }
  permit(): { generation: bigint } | null {
    return this.generation === null ? null : { generation: this.generation };
  }
  acquire(generation: bigint): void {
    if (generation <= this.highestGeneration)
      throw new Error("generation_must_advance");
    this.generation = generation;
    this.highestGeneration = generation;
  }
  lose(): void {
    if (this.generation !== null) {
      this.generation = null;
      this.lossSequence += 1;
    }
  }
}
