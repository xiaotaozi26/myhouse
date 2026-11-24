#!/usr/bin/env python3
"""双击运行：规范视频及录屏命名、检查 01–40、调用桌面检测工具导出 CSV。"""
import collections
import csv
import datetime
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path.home() / 'Desktop'
APP = Path.home() / 'Desktop/人脸采集_检测工具 5.app'
VIDEO_EXTENSIONS = {'.mov', '.mp4', '.m4v', '.avi', '.mkv'}
NUMBER = re.compile(r'(\d+)[_-](\d{2})')


def osascript(source, *args):
    result = subprocess.run(['/usr/bin/osascript', '-e', source, *map(str, args)],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def videos(folder):
    return sorted(p for p in folder.iterdir()
                  if p.is_file() and p.suffix.lower() in VIDEO_EXTENSIONS)


def description(path):
    probe = shutil.which('ffprobe') or '/opt/homebrew/bin/ffprobe'
    result = subprocess.run([probe, '-v', 'error', '-show_entries', 'format_tags',
                             '-of', 'json', str(path)], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(f'读取描述失败：{path.name}\n{result.stderr.strip()}')
    tags = json.loads(result.stdout).get('format', {}).get('tags', {})
    return str(tags.get('com.apple.quicktime.description') or tags.get('description') or '').strip()


def recording_name(text, prefix):
    text = re.sub(r'^\d+[_-]', '', text.casefold())
    brands = [name for name, aliases in [
        ('轻颜', ('轻颜',)), ('b612', ('b612',)),
        ('无他', ('无他',)), ('一甜', ('一甜',)),
    ] if any(alias in text for alias in aliases)]
    if 'b612' not in brands and re.search(r'(?<!\d)612(?!\d)', text):
        brands.append('b612')
    if len(brands) > 1:
        raise ValueError(f'名称包含多个美颜APP，请确认类别：{text}')
    if brands:
        category = brands[0] + '美颜APP有美颜参数录屏'
    elif ('安卓' in text or 'android' in text) and '美颜' in text and '无美颜' not in text:
        category = 'Android原生有美颜参数录屏'
    elif '原生相机' in text:
        category = '原生相机无美颜参数录屏'
    elif '美颜app' in text:
        category = '美颜APP有美颜参数录屏'
    else:
        return ''
    return f'{prefix}_{category}'


def rename_plan(folder, read_description=description):
    plan = []
    destinations = {}
    for source in videos(folder):
        text = read_description(source)
        if not text and NUMBER.fullmatch(source.stem):
            text = source.stem
        if not NUMBER.fullmatch(text) and not NUMBER.fullmatch(source.stem):
            text = recording_name(text, folder.name) or recording_name(source.stem, folder.name) or text
        if not text:
            continue
        if text in {'.', '..'} or any(c in text for c in '/:\x00\n\r'):
            raise ValueError(f'描述含不能用于文件名的字符：{source.name}')
        match = NUMBER.fullmatch(text)
        if match:
            prefix, number = match.groups()
            if prefix != folder.name:
                raise ValueError(f'描述 {text} 与文件夹 {folder.name} 不一致：{source.name}')
            text = f'{prefix}_{number}'
        target = source.with_name(f'{text}{source.suffix}')
        key = target.name.casefold()
        if key in destinations:
            raise ValueError(f'重名冲突：{source.name} 与 {destinations[key]} → {target.name}')
        destinations[key] = source.name
        if source == target:
            continue
        if any(p.name.casefold() == key for p in folder.iterdir()):
            raise ValueError(f'重名冲突，目标已存在：{source.name} → {target.name}')
        stat = source.stat()
        plan.append((source, target, stat.st_ino, stat.st_size))
    return plan


def apply_renames(plan):
    for source, target, inode, size in plan:
        stat = source.stat()
        if (stat.st_ino, stat.st_size) != (inode, size) or target.exists():
            raise RuntimeError(f'文件发生变化，停止改名：{source.name}')
    for source, target, inode, size in plan:
        # 同目录建立硬链接再删除旧名称，目标已存在时绝不覆盖。
        os.link(source, target)
        source.unlink()
        stat = target.stat()
        if source.exists() or (stat.st_ino, stat.st_size) != (inode, size):
            raise RuntimeError(f'改名后校验失败：{target.name}')
        print(f'{source.name} → {target.name}', flush=True)


def number_issues(paths, prefix):
    numbered = collections.defaultdict(list)
    issues = []
    for path in paths:
        match = NUMBER.fullmatch(path.stem)
        if not match:
            continue
        group, number = match.groups()
        if group != prefix:
            issues.append(f'其他编号组：{path.name}')
        elif not 1 <= int(number) <= 40:
            issues.append(f'范围外：{path.name}')
        elif '-' in path.stem:
            issues.append(f'名称仍含横杠：{path.name}')
        else:
            numbered[int(number)].append(path.name)
    missing = [f'{prefix}_{i:02d}' for i in range(1, 41) if i not in numbered]
    if missing:
        issues.insert(0, '缺少：' + '、'.join(missing))
    for number, names in sorted(numbered.items()):
        if len(names) > 1:
            issues.append(f'重复编号：{prefix}_{number:02d}（' + '、'.join(names) + '）')
    return issues


def error_summary(rows):
    ignored = {'错误_时长超过20秒', '错误_非SDR_BT709'}
    failures = []
    for row in rows:
        errors = [key[3:] for key, value in row.items()
                  if key.startswith('错误_') and key not in ignored
                  and (value or '').strip() not in ('', '0')]
        if (row.get('检查失败') or '').strip():
            errors.append('检查失败：' + row['检查失败'].strip())
        if errors:
            failures.append(row['文件名'] + '：' + '；'.join(errors))
    note = '已忽略：时长超过20秒、非SDR/BT.709。'
    if not failures:
        return note + '\n未发现需要处理的错误。'
    return '\n'.join([note, f'有错误的视频：{len(failures)}/{len(rows)}', *failures])


AUTOMATION = r'''
on findButton(labelText)
    tell application "System Events"
        tell (first application process whose bundle identifier is "local.zhishu.videorulechecker")
            set windowItems to entire contents of front window
            repeat with itemRef in windowItems
                try
                    if role of itemRef is "AXButton" and name of itemRef is labelText then return contents of itemRef
                end try
            end repeat
        end tell
    end tell
    error "找不到按钮：" & labelText
end findButton

on hasText(expectedText)
    tell application "System Events"
        tell (first application process whose bundle identifier is "local.zhishu.videorulechecker")
            set windowItems to entire contents of front window
            repeat with itemRef in windowItems
                try
                    if role of itemRef is "AXStaticText" then
                        if (value of itemRef as text) starts with expectedText then return true
                    end if
                end try
            end repeat
        end tell
    end tell
    return false
end hasText

on findField(fieldID)
    tell application "System Events"
        tell (first application process whose bundle identifier is "local.zhishu.videorulechecker")
            repeat with windowRef in windows
                set windowItems to entire contents of windowRef
                repeat with itemRef in windowItems
                    try
                        if value of attribute "AXIdentifier" of itemRef is fieldID then return contents of itemRef
                    end try
                end repeat
            end repeat
        end tell
    end tell
    return missing value
end findField

on goToFolder(folderPath)
    tell application "System Events"
        tell (first application process whose bundle identifier is "local.zhishu.videorulechecker")
            keystroke "g" using {command down, shift down}
        end tell
    end tell
    repeat 50 times
        set pathField to my findField("PathTextField")
        if pathField is not missing value then exit repeat
        delay 0.1
    end repeat
    if pathField is missing value then error "找不到路径输入框"
    tell application "System Events"
        set value of pathField to folderPath
        tell (first application process whose bundle identifier is "local.zhishu.videorulechecker") to keystroke return
    end tell
    repeat 50 times
        if my findField("PathTextField") is missing value then return
        delay 0.1
    end repeat
    error "跳转文件夹超时"
end goToFolder

on run argv
    set folderPath to item 1 of argv
    set outputFolder to item 2 of argv
    set outputName to item 3 of argv
    set appPath to item 4 of argv
    tell application appPath to activate
    tell application "System Events"
        repeat 100 times
            if exists (first application process whose bundle identifier is "local.zhishu.videorulechecker") then
                if (count of windows of (first application process whose bundle identifier is "local.zhishu.videorulechecker")) > 0 then exit repeat
            end if
            delay 0.1
        end repeat
    end tell
    set chooseButton to my findButton("选择视频文件夹")
    tell application "System Events"
        if not enabled of chooseButton then error "App 正在检测，请等当前检测结束后再运行人脸_数据处理。"
        click chooseButton
    end tell
    my goToFolder(folderPath)
    tell application "System Events" to click my findButton("选择")
    repeat 50 times
        if my hasText(folderPath) then exit repeat
        delay 0.1
    end repeat
    if not my hasText(folderPath) then error "App 没有选中目标文件夹，已停止。"
    tell application "System Events" to click my findButton("开始精细检测")
    set completed to false
    repeat 28800 times
        delay 1
        if my hasText("完成：") then
            tell application "System Events" to set completed to enabled of my findButton("另存CSV")
            if completed then exit repeat
        end if
    end repeat
    if not completed then error "等待检测超时（8小时），未导出CSV。"
    tell application "System Events" to click my findButton("另存CSV")
    my goToFolder(outputFolder)
    set nameField to my findField("saveAsNameTextField")
    if nameField is missing value then error "找不到CSV文件名输入框"
    tell application "System Events"
        set value of nameField to outputName
        click my findButton("保存")
    end tell
end run
'''


def main():
    print('人脸_数据处理：视频及录屏改名 → 检查40条 → 人脸检测 → 保存CSV\n', flush=True)
    folder = Path(osascript('''on run argv
        return POSIX path of (choose folder with prompt "选择编号文件夹，例如 177" default location (POSIX file (item 1 of argv)))
        end run''', ROOT)).resolve()
    if not folder.name.isdigit():
        raise ValueError('请选择编号文件夹，例如 149。')
    if not APP.is_dir():
        raise RuntimeError(f'找不到检测工具：{APP}')
    print(f'文件夹：{folder}\n\nStep 1：读取视频描述、检查重名', flush=True)
    plan = rename_plan(folder)
    apply_renames(plan)
    print(f'已改名 {len(plan)} 个视频。\n\nStep 2：检查01–40', flush=True)
    issues = number_issues(videos(folder), folder.name)
    if issues:
        raise ValueError('\n'.join(issues) + '\n已停止，未开始人脸检测。')
    print('完整40个', flush=True)
    output = folder.parent / f'视频规则检测结果_精细{folder.name}.csv'
    if output.exists():
        stamp = datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        output = folder.parent / f'视频规则检测结果_精细_{stamp}_{folder.name}.csv'
    print('\nStep 3：调用检测工具，请在完成前不要操作它的窗口。', flush=True)
    print('首次使用若系统要求授权，请允许终端控制 System Events，并在辅助功能中允许终端。', flush=True)
    osascript(AUTOMATION, folder, output.parent, output.name, APP)
    for _ in range(100):
        if output.is_file() and output.stat().st_size > 0:
            break
        time.sleep(0.1)
    else:
        raise RuntimeError(f'未找到导出的CSV：{output}')
    with output.open(encoding='utf-8-sig', newline='') as file:
        rows = list(csv.DictReader(file))
    if len(rows) < 40:
        raise RuntimeError(f'CSV已保存，但数据少于40行，请检查：{output}')
    print(f'\n检测完成，CSV已保存：\n{output}', flush=True)
    print('\nStep 4：错误汇总\n' + error_summary(rows), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        if '(-128)' in str(error):
            print('\n已取消。')
        else:
            print(f'\n停止：{error}', file=sys.stderr)
        status = 1
    else:
        status = 0
    if sys.stdin.isatty():
        try:
            input('\n按回车退出……')
        except (EOFError, KeyboardInterrupt):
            pass
    sys.exit(status)
