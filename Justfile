default:
    @just --list

# Preserve the complete local validation path.
validate:
    ./tests/validate.sh

validate-javascript:
    ./tests/validate.sh javascript

validate-package:
    ./tests/validate.sh package

test-ci:
    uv run --no-project --with PyYAML==6.0.3 python -m unittest discover -s tests -p 'test_*.py'
