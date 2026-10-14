#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>
#include <map>
#include <algorithm>

struct Guard {
  const char *n;
  explicit Guard(const char *n) : n(n) { printf("ctor %s\n", n); }
  ~Guard() { printf("dtor %s\n", n); }
};

static int thrower(int x) {
  Guard g("thrower");
  if (x > 2) throw std::runtime_error("too big");
  return x;
}
static int mid(int x) {
  Guard g("mid");
  return thrower(x) + 1;
}

struct Base { virtual ~Base() {} virtual const char *name() const { return "Base"; } };
struct Derived : Base { const char *name() const override { return "Derived"; } };

int main() {
  try {
    printf("%d\n", mid(1));
    printf("%d\n", mid(5));
    printf("not reached\n");
  } catch (const std::exception &e) {
    printf("caught: %s\n", e.what());
  }
  try { throw 42; } catch (int v) { printf("int %d\n", v); }
  try {
    try { throw std::string("inner"); }
    catch (const std::string &s) { printf("rethrow %s\n", s.c_str()); throw; }
  } catch (...) { printf("catch-all\n"); }
  std::vector<std::string> v = {"pear", "apple", "fig"};
  std::sort(v.begin(), v.end());
  std::map<std::string, int> m;
  for (auto &s : v) m[s] = (int)s.size();
  for (auto &kv : m) printf("%s=%d\n", kv.first.c_str(), kv.second);
  Base *b = new Derived;
  printf("%s %d\n", b->name(), dynamic_cast<Derived *>(b) != nullptr);
  delete b;
  try { v.at(10); } catch (const std::out_of_range &) { printf("out_of_range\n"); }
  return 3;
}
