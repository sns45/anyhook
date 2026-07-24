package core

// FullJitter returns a uniform random delay in [0, baseMs). Avoids thundering
// herds when a receiver recovers.
func FullJitter(baseMs int64, rng Rng) int64 {
	return int64(float64(baseMs) * rng.Next())
}
