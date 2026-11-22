# The game PC's desktop help picture: black, pale green, flat colours only.
# Draws lib/assets/ayis-help.png (needs Pillow and the DejaVu fonts, on a
# developer's machine only - the box is sent the finished picture):
#     python3 -I tools/draw-wallpaper.py lib/assets/ayis-help.png
# Flat fills and no gradient on purpose: a stream at a low bitrate bands a gradient
# and smears fine detail, while flat black with sharp, large text stays clean.
import sys

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
D = "/usr/share/fonts/truetype/dejavu/"


def f(name, size):
    return ImageFont.truetype(D + name, size)


mono, monob = "DejaVuSansMono.ttf", "DejaVuSansMono-Bold.ttf"

BG = (0, 0, 0)
GREEN = (170, 255, 170)      # the text
BRIGHT = (210, 255, 210)     # headings and keys
DIM = (96, 168, 96)          # the quieter lines
img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

PX0, PY0, PX1, PY1 = 700, 60, 1860, 868
d.rectangle((PX0, PY0, PX1, PY1), outline=GREEN, width=2)
x = PX0 + 48


class Pen:
    """Writes down the panel; y is where the next line goes."""
    y = PY0 + 30

    def head(self, text):
        d.text((x, self.y), "# " + text.upper(), font=f(monob, 24), fill=BRIGHT)
        d.line((x, self.y + 36, PX1 - 48, self.y + 36), fill=DIM, width=2)
        self.y += 50

    def key(self, k, words):
        kf = f(monob, 26)
        d.rectangle((x, self.y - 4, x + 40, self.y + 36), outline=GREEN, width=2)
        d.text((x + 20, self.y + 16), k, font=kf, fill=BRIGHT, anchor="mm")
        d.text((x + 72, self.y + 2), words, font=f(mono, 24), fill=GREEN)
        self.y += 45

    def line(self, words, color=GREEN, size=24, gap=34):
        d.text((x, self.y), words, font=f(mono, size), fill=color)
        self.y += gap


p = Pen()
d.text((x, p.y), "> your game PC_", font=f(monob, 44), fill=BRIGHT)
p.y += 82

p.head("moonlight keys   hold Ctrl + Alt + Shift, then press")
p.key("Z", "release the mouse and keyboard, again to give them back")
p.key("X", "fullscreen or windowed")
p.key("D", "minimise the stream")
p.key("Q", "stop the stream (the game keeps running here)")
p.y += 2
p.line("while the stream has focus, Super and Windows shortcuts go to", DIM, 21, 28)
p.line("this PC; press Z to use your own. on a Mac: Command + Option.", DIM, 21, 28)
p.y += 12

p.head("added a games disk?")
p.line("Steam > Settings > Storage > Add Drive > the drive at /scratch2 (ayisextra)")
p.y += 10

p.head("before you delete this machine")
# the one warning, inverted so it stands out without a second colour
d.rectangle((x - 8, p.y - 4, PX1 - 40, p.y + 36), fill=GREEN)
d.text((x + 4, p.y + 2), "games still downloading are NOT saved. let them finish.", font=f(monob, 25), fill=BG)
p.y += 52
p.line("finished games are saved for the next machine you build.")
p.y += 10

p.head("it switches itself off")
p.line("after 15 minutes with no stream, download or install.")
p.line("on spot that deletes the machine; finished games are saved first.", DIM, 21, 30)

out = sys.argv[1] if len(sys.argv) > 1 else "wallpaper.png"
img.save(out, optimize=True)
print(out, "content ends", p.y, "panel ends", PY1)
