#include <windows.h>
#include <stdio.h>

static int timers = 0, paints = 0, keys = 0, clicks = 0, sizes = 0, activated = 0, chars = 0;
static char log_[256];
static int lastw = 0, lasth = 0;

static LRESULT CALLBACK WndProc(HWND h, UINT m, WPARAM w, LPARAM l) {
  switch (m) {
    case WM_CREATE: {
      CREATESTRUCTA *cs = (CREATESTRUCTA *)l;
      printf("WM_CREATE title=%s cx=%d cy=%d\n", cs->lpszName, cs->cx, cs->cy);
      SetTimer(h, 7, 20, NULL);
      return 0;
    }
    case WM_SIZE:
      lastw = LOWORD(l); lasth = HIWORD(l); sizes++;
      return 0;
    case WM_ACTIVATE:
      if (LOWORD(w) != WA_INACTIVE) activated++;
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      HBRUSH br = CreateSolidBrush(RGB(255, 0, 0));
      RECT r = {10, 10, 60, 40};
      FillRect(dc, &r, br);
      DeleteObject(br);
      HPEN pen = CreatePen(PS_SOLID, 1, RGB(0, 255, 0));
      HGDIOBJ old = SelectObject(dc, pen);
      MoveToEx(dc, 0, 100, NULL);
      LineTo(dc, 99, 100);
      SelectObject(dc, old);
      DeleteObject(pen);
      SetPixel(dc, 5, 5, RGB(0, 0, 255));
      // memory DC blit
      HDC mdc = CreateCompatibleDC(dc);
      BITMAPINFO bi = {0};
      bi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
      bi.bmiHeader.biWidth = 4; bi.bmiHeader.biHeight = -4; bi.bmiHeader.biPlanes = 1; bi.bmiHeader.biBitCount = 32;
      void *bits;
      HBITMAP bmp = CreateDIBSection(mdc, &bi, DIB_RGB_COLORS, &bits, NULL, 0);
      HGDIOBJ ob = SelectObject(mdc, bmp);
      for (int i = 0; i < 16; i++) ((DWORD *)bits)[i] = 0x00ffff00; // BGRX -> RGB(255,255,0)
      BitBlt(dc, 100, 50, 4, 4, mdc, 0, 0, SRCCOPY);
      StretchBlt(dc, 120, 50, 8, 8, mdc, 0, 0, 4, 4, SRCCOPY);
      SelectObject(mdc, ob);
      DeleteObject(bmp);
      DeleteDC(mdc);
      EndPaint(h, &ps);
      paints++;
      return 0;
    }
    case WM_TIMER:
      timers++;
      if (timers == 3) {
        InvalidateRect(h, NULL, FALSE);
      }
      if (timers == 6) { KillTimer(h, 7); PostMessage(h, WM_USER + 1, 0, 0); }
      return 0;
    case WM_KEYDOWN: keys++; printf("keydown vk=%02x\n", (unsigned)w); return 0;
    case WM_CHAR: chars++; printf("char %c\n", (char)w); return 0;
    case WM_LBUTTONDOWN: clicks++; printf("click %d,%d\n", LOWORD(l), HIWORD(l)); return 0;
    case WM_USER + 1:
      printf("user msg; closing\n");
      DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      printf("WM_DESTROY\n");
      PostQuitMessage(5);
      return 0;
  }
  return DefWindowProcA(h, m, w, l);
}

int main(void) {
  WNDCLASSEXA wc = {0};
  wc.cbSize = sizeof(wc);
  wc.lpfnWndProc = WndProc;
  wc.hInstance = GetModuleHandle(NULL);
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hbrBackground = (HBRUSH)GetStockObject(BLACK_BRUSH);
  wc.lpszClassName = "TestWnd";
  if (!RegisterClassExA(&wc)) { printf("register failed\n"); return 1; }
  RECT r = {0, 0, 320, 240};
  AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
  printf("adjusted %ld,%ld\n", r.right - r.left, r.bottom - r.top);
  HWND h = CreateWindowExA(0, "TestWnd", "Hello", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 50, 60, r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);
  if (!h) { printf("create failed %lu\n", GetLastError()); return 2; }
  RECT cr;
  GetClientRect(h, &cr);
  printf("client %ldx%ld\n", cr.right, cr.bottom);
  MSG msg;
  while (GetMessageA(&msg, NULL, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageA(&msg);
  }
  printf("timers=%d paints>0=%d keys=%d chars=%d clicks=%d activated>0=%d sizes>0=%d size=%dx%d quit=%d\n", timers, paints > 0, keys, chars, clicks, activated > 0, sizes > 0, lastw, lasth, (int)msg.wParam);
  printf("sysmetrics %d %d\n", GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN));
  return (int)msg.wParam;
}
