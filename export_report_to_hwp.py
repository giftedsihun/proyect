from pathlib import Path

import win32com.client


ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "secure-message-research-report.docx"
OUTPUT = ROOT / "secure-message-research-report.hwp"


def main():
    hwp = win32com.client.Dispatch("HWPFrame.HwpObject")
    try:
        # Allow the local, user-created document paths in Hancom's automation API.
        hwp.RegisterModule("FilePathCheckDLL", "FilePathCheckerModule")
        if not hwp.Open(str(SOURCE), "", ""):
            raise RuntimeError(f"Could not open {SOURCE.name} in Hancom Office.")
        if not hwp.SaveAs(str(OUTPUT), "HWP", ""):
            raise RuntimeError(f"Could not save {OUTPUT.name}.")
    finally:
        hwp.Quit()
    print(OUTPUT)


if __name__ == "__main__":
    main()
