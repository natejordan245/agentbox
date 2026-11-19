import { expect, test } from "bun:test";
import { cleanSwears } from "../swears";

test("a swear in your prompt is swapped for a mild word", () => {
  expect(cleanSwears("this retarded test")).toBe("this silly test");
  expect(cleanSwears("you retard")).toBe("you goofball");
  expect(cleanSwears("fuck it, damn it, shit")).toBe("flip it, dang it, crap");
  expect(cleanSwears("the fucking build is fucked")).toBe("the flipping build is flipped");
});

test("the swear's case carries over", () => {
  expect(cleanSwears("Fuck. FUCK. fuck")).toBe("Flip. FLIP. flip");
  expect(cleanSwears("Damn")).toBe("Dang");
});

test("a word that only holds a swear stays as written", () => {
  const plain = "assess the shiitake in Scunthorpe, a classic passage; shitake and damnation";
  expect(cleanSwears(plain)).toBe(plain);
});
