"""Reader Companion: a Jupyter server the reader's Playground can pair with."""

__version__ = "0.7.3"


def _jupyter_server_extension_points():
    return [{"module": "reader_companion"}]


def _load_jupyter_server_extension(serverapp):
    from .extension import load

    load(serverapp)
