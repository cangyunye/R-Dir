; v0.46 资源管理器右键集成（NSIS 安装钩子）
; HKCU 写入免管理员（Tauri NSIS 默认 currentUser 安装模式）：
;   目录 / 目录空白处 / 任意文件 三处右键各注册 OpenWithRDir 动词，
;   命令带路径启动 —— 已运行实例经 single-instance 插件转发为新标签。
; 便携版 / 手动开关走应用内设置（设置 → 系统集成），注销亦可在应用内完成。

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithRDir" "" "用 R-Dir 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithRDir" "Icon" "$INSTDIR\R-Dir.exe"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenWithRDir\command" "" '"$INSTDIR\R-Dir.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithRDir" "" "用 R-Dir 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithRDir" "Icon" "$INSTDIR\R-Dir.exe"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenWithRDir\command" "" '"$INSTDIR\R-Dir.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithRDir" "" "用 R-Dir 打开"
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithRDir" "Icon" "$INSTDIR\R-Dir.exe"
  WriteRegStr HKCU "Software\Classes\*\shell\OpenWithRDir\command" "" '"$INSTDIR\R-Dir.exe" "%1"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenWithRDir"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenWithRDir"
  DeleteRegKey HKCU "Software\Classes\*\shell\OpenWithRDir"
!macroend
