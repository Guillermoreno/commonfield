type Delivery = (message: string) => void;

export type GenerationSubscription = {
  readonly generation: bigint;
  readonly active: boolean;
};

export class GenerationDeliveryRegistry {
  private generation: bigint | null = null;
  private readonly subscriptions = new Set<{
    generation: bigint;
    deliver: Delivery;
    active: boolean;
  }>();

  activate(generation: bigint): void {
    if (this.generation === generation) return;
    if (this.generation !== null && generation <= this.generation)
      throw new Error("generation_must_advance");
    this.generation = generation;
  }

  currentGeneration(): bigint | null {
    return this.generation;
  }

  lose(generation: bigint): void {
    if (this.generation !== generation) return;
    this.generation = null;
    for (const subscription of this.subscriptions) {
      if (subscription.generation === generation) subscription.active = false;
    }
  }

  subscribe(generation: bigint, deliver: Delivery): GenerationSubscription {
    const subscription = {
      generation,
      deliver,
      active: this.generation === generation,
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  unsubscribe(handle: GenerationSubscription): void {
    for (const subscription of this.subscriptions) {
      if (subscription === handle) {
        subscription.active = false;
        this.subscriptions.delete(subscription);
        return;
      }
    }
  }

  deliver(
    generation: bigint,
    message: string,
    acknowledge: () => void,
  ): boolean {
    if (this.generation !== generation) return false;
    acknowledge();
    for (const subscription of this.subscriptions) {
      if (subscription.active && subscription.generation === generation)
        subscription.deliver(message);
    }
    return true;
  }
}
