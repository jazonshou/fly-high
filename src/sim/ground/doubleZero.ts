/**
 * Zero, as V8 holds a double.
 *
 * V8 gives an object's field the representation of the first number stored
 * in it, and a field that starts at the integer 0 stays an integer field
 * until its first fraction. That fraction re-shapes the object, and every
 * optimised function that has seen the old shape throws its code away and
 * runs unoptimised until V8 compiles it again. On the car that is nearly the
 * whole step: the first 4H shift, scrape, bump stop or ford of a session
 * each cost a run of 2 to 8 ms steps. A field that will hold fractions
 * starts from `DOUBLE_ZERO`, the one zero V8 cannot hold as an integer; it
 * adds, multiplies and compares as 0.
 */
export const DOUBLE_ZERO = -0;
