/**
 * The data lake's 64,000-ledger partitions: a rebuild's manifest lists the rows of each partition with
 * their own hash, so two results can be compared partition by partition.
 */
export const PARTITION_SIZE = 64_000;

export interface PartitionRange {
  /** The data lake partition's first ledger: the partition's key. */
  readonly start: number;
  readonly end: number;
  /** The first ledger to index in it (the range may start inside the partition). */
  readonly from: number;
  /** The last ledger to index in it. */
  readonly to: number;
}

/** The partitions covering `from`..`to`, clipped to the range. */
export function partitionsBetween(from: number, to: number): PartitionRange[] {
  const ranges: PartitionRange[] = [];
  for (let start = Math.floor(from / PARTITION_SIZE) * PARTITION_SIZE; start <= to; start += PARTITION_SIZE) {
    const end = start + PARTITION_SIZE - 1;
    ranges.push({ start, end, from: Math.max(start, from), to: Math.min(end, to) });
  }
  return ranges;
}
