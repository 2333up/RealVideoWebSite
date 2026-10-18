# -*- coding: utf-8 -*-
"""几何探针：不依赖肉眼截图，直接打印桌宠/气泡窗口与绘制尺寸。"""
import os
import sys

BUILD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "build", "Jingxi")
sys.path.insert(0, BUILD)
os.chdir(BUILD)

from PyQt6.QtWidgets import QApplication

import main as petmod

app = QApplication(sys.argv)
screen = app.primaryScreen()
print("screen geometry     =", screen.geometry())
print("available geometry  =", screen.availableGeometry())
print("devicePixelRatio    =", screen.devicePixelRatio())

cfg = petmod.load_config()
pet = petmod.PetWidget(cfg)
pet.show()
app.processEvents()

print("pet nat             =", pet.nat_w, "x", pet.nat_h)
print("pet disp            =", pet.disp_w, "x", pet.disp_h)
print("pet window          =", pet.geometry())
print("draw_pix            =", pet.draw_pix.width(), "x", pet.draw_pix.height())
print("base_pix            =", pet.base_pix.width(), "x", pet.base_pix.height())

pet._react("poke")
app.processEvents()
print("bubble size         =", pet.bubble.width(), "x", pet.bubble.height())
print("bubble pos          =", pet.bubble.x(), pet.bubble.y())
print("bubble 应居中的 x    =", pet.x() + (pet.width() - pet.bubble.width()) // 2)
print("pet 水平中心         =", pet.x() + pet.width() // 2)
